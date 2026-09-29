// ─── Sessions that were there when Hermes started ─────────────────────
//
// The morning view (the attention inbox opening by itself) is for agents
// that were already waiting when Hermes started: the sessions Hermes
// restored or reattached at startup. A session started afterwards that asks
// for something never opens it. SessionContext marks them as it restores.

const ids = new Set<string>();

export function markStartupSession(sessionId: string): void {
  ids.add(sessionId);
}

export function isStartupSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && ids.has(sessionId);
}

/** Test-only. */
export function _resetStartupSessionsForTest(): void {
  ids.clear();
}
