// ─── Agent doctor results, shared ──────────────────────────────────────
//
// The doctor asks every agent CLI for its version and sign-in state, which
// takes a moment, so its answer is kept for the app's lifetime and shared by
// the three places that show it: the welcome screens, Settings > Agents and
// the task launcher (which needs it for the "signed out" row). "Check again"
// re-runs it; nothing re-runs it on its own.

import { useCallback, useSyncExternalStore } from "react";
import { runAgentDoctor, type DoctorRow } from "../api/doctor";

export interface DoctorState {
  rows: DoctorRow[] | null;
  loading: boolean;
  error: string | null;
}

let state: DoctorState = { rows: null, loading: false, error: null };
let inFlight: Promise<DoctorRow[] | null> | null = null;
const listeners = new Set<() => void>();
let runner: () => Promise<DoctorRow[]> = runAgentDoctor;

function set(next: DoctorState) {
  state = next;
  for (const l of listeners) l();
}

/** Run the doctor (once at a time); resolves with the rows, or null on failure. */
export function refreshDoctor(): Promise<DoctorRow[] | null> {
  if (inFlight) return inFlight;
  set({ ...state, loading: true, error: null });
  inFlight = runner()
    .then((rows) => {
      set({ rows, loading: false, error: null });
      return rows;
    })
    .catch((err: unknown) => {
      set({ ...state, loading: false, error: err instanceof Error ? err.message : String(err) });
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Run the doctor unless it already ran (or is running). */
export function ensureDoctor(): void {
  if (!state.rows && !inFlight) void refreshDoctor();
}

export function getDoctorState(): DoctorState {
  return state;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The doctor's current answer, and a way to ask again. */
export function useAgentDoctor(): DoctorState & { refresh: () => void } {
  const snapshot = useSyncExternalStore(subscribe, getDoctorState, getDoctorState);
  const refresh = useCallback(() => void refreshDoctor(), []);
  return { ...snapshot, refresh };
}

/** Rows by agent id. */
export function doctorById(rows: readonly DoctorRow[] | null): Record<string, DoctorRow> {
  const out: Record<string, DoctorRow> = {};
  for (const r of rows ?? []) out[r.id] = r;
  return out;
}

/** Test-only: forget the cached answer and use another runner. */
export function __resetDoctorForTest(fake?: () => Promise<DoctorRow[]>): void {
  state = { rows: null, loading: false, error: null };
  inFlight = null;
  runner = fake ?? runAgentDoctor;
  for (const l of listeners) l();
}
