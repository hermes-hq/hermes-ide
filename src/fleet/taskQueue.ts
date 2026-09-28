// ─── Task queue and concurrency cap (N22) ─────────────────────────────
//
// With a cap on running agents (a count, memory, or both) set in
// Settings > Limits, a new agent task that finds no free slot waits here
// instead of starting. The next task starts on its own as soon as a slot
// frees, oldest first. "Start now" skips the wait for one task.
//
// A slot is held by an agent session that is still working on its task.
// It frees when the agent says its turn is done or it went idle, when the
// agent exits, or when the session closes. Without any word from the agent
// Hermes looks at the process: a shell with no program left running has
// nothing in the slot. A new session holds its slot while its agent starts.

import { useSyncExternalStore } from "react";
import type { AgentStatus } from "../agent/contract/status";
import type { CreateSessionOpts } from "../types/session";
import type { FleetCaps } from "./fleetSettings";

/** How long a new agent session holds its slot before its agent shows up. */
export const STARTUP_GRACE_MS = 30_000;

// ── Which sessions hold a slot (pure) ─────────────────────────────────

export interface SlotInput {
  /** Started with an agent (any agent, the Custom one included). */
  readonly isAgent: boolean;
  /** Closed or closing. */
  readonly closed: boolean;
  /** The status from the session's events, and whether any event said it. */
  readonly status: AgentStatus;
  readonly statusReported: boolean;
  /** The `hi` helper saw the agent end. */
  readonly startupEnded: boolean;
  /** From the process table: a program runs in the shell (null: unknown). */
  readonly running: boolean | null;
  /** A program was seen running in this session at some point. */
  readonly seenRunning: boolean;
  /** Milliseconds since the session was created. */
  readonly ageMs: number;
}

const FREE_STATUS = new Set(["done_unread", "idle", "exited"]);

export function occupiesSlot(s: SlotInput): boolean {
  if (!s.isAgent || s.closed || s.startupEnded) return false;
  if (s.statusReported && FREE_STATUS.has(s.status.kind)) return false;
  if (s.running === true) return true;
  if (s.running === false) return !s.seenRunning && s.ageMs < STARTUP_GRACE_MS;
  // No process to look at (the Agent view): held until the agent says otherwise.
  return true;
}

export interface Occupancy {
  /** Sessions holding a slot. */
  readonly sessionIds: readonly string[];
  /** Memory of the agents holding a slot, in bytes. */
  readonly memoryBytes: number;
}

export function hasFreeSlot(occupancy: Occupancy, caps: Pick<FleetCaps, "maxRunning" | "maxMemoryMb">, starting = 0): boolean {
  if (caps.maxRunning !== null && occupancy.sessionIds.length + starting >= caps.maxRunning) return false;
  if (caps.maxMemoryMb !== null && occupancy.memoryBytes >= caps.maxMemoryMb * 1024 * 1024) return false;
  return true;
}

export function queueEnabled(caps: Pick<FleetCaps, "maxRunning" | "maxMemoryMb">): boolean {
  return caps.maxRunning !== null || caps.maxMemoryMb !== null;
}

// ── The queue (store) ─────────────────────────────────────────────────

export interface QueuedTask {
  readonly id: string;
  readonly opts: CreateSessionOpts;
  /** For the queued row: the task's name, or the agent's. */
  readonly label: string;
  readonly enqueuedAt: number;
}

type Listener = () => void;
let queue: readonly QueuedTask[] = Object.freeze([]);
const listeners = new Set<Listener>();
let nextId = 1;
let clock: () => number = () => Date.now();

function publish(next: readonly QueuedTask[]): void {
  queue = Object.freeze(next);
  for (const l of [...listeners]) l();
}

export function enqueueTask(opts: CreateSessionOpts, label: string): QueuedTask {
  const task: QueuedTask = Object.freeze({ id: `task-${nextId++}`, opts, label, enqueuedAt: clock() });
  publish([...queue, task]);
  return task;
}

/** Take a task out of the queue (to start it, or because it was removed). */
export function removeTask(id: string): QueuedTask | null {
  const task = queue.find((t) => t.id === id) ?? null;
  if (task) publish(queue.filter((t) => t.id !== id));
  return task;
}

/** Oldest first. */
export function listQueuedTasks(): readonly QueuedTask[] {
  return queue;
}

export function subscribeTaskQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTaskQueue(): readonly QueuedTask[] {
  return useSyncExternalStore(subscribeTaskQueue, listQueuedTasks, listQueuedTasks);
}

export function _resetTaskQueueForTest(now?: () => number): void {
  queue = Object.freeze([]);
  listeners.clear();
  nextId = 1;
  clock = now ?? (() => Date.now());
}

// ── What the queue shows: slots in use, and "Start now" ───────────────

const EMPTY_OCCUPANCY: Occupancy = Object.freeze({ sessionIds: Object.freeze([]) as readonly string[], memoryBytes: 0 });
let occupancy: Occupancy = EMPTY_OCCUPANCY;
const occupancyListeners = new Set<Listener>();

/** The fleet hook publishes who holds a slot each time it looks. */
export function publishOccupancy(next: Occupancy): void {
  if (
    next.memoryBytes === occupancy.memoryBytes &&
    next.sessionIds.length === occupancy.sessionIds.length &&
    next.sessionIds.every((id, i) => id === occupancy.sessionIds[i])
  ) {
    return;
  }
  occupancy = Object.freeze({ sessionIds: Object.freeze([...next.sessionIds]), memoryBytes: next.memoryBytes });
  for (const l of [...occupancyListeners]) l();
}

export function getOccupancy(): Occupancy {
  return occupancy;
}

function subscribeOccupancy(listener: Listener): () => void {
  occupancyListeners.add(listener);
  return () => {
    occupancyListeners.delete(listener);
  };
}

export function useOccupancy(): Occupancy {
  return useSyncExternalStore(subscribeOccupancy, getOccupancy, getOccupancy);
}

let starter: ((task: QueuedTask) => void) | null = null;

/** The fleet hook registers how a task is started. */
export function registerTaskStarter(fn: ((task: QueuedTask) => void) | null): void {
  starter = fn;
}

/** "Start now": skip the wait for one task. False when it is no longer queued. */
export function startTaskNow(id: string): boolean {
  if (!starter) return false;
  const task = removeTask(id);
  if (!task) return false;
  starter(task);
  return true;
}

export function _resetOccupancyForTest(): void {
  occupancy = EMPTY_OCCUPANCY;
  occupancyListeners.clear();
  starter = null;
}
