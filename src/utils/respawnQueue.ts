/**
 * Per-session respawn lock on the frontend.
 *
 * Two restarts of one Agent view session that start while the first is still
 * running (a double-clicked Retry, a message submit racing a card's reply)
 * must produce one agent process. The backend serializes restarts under its
 * own per-session lock, but it can only merge requests that reach it at the
 * same time; on a slow machine the second click's request can arrive after
 * the first restart already finished and would start a second process. The
 * page knows both requests were meant as one, so it merges them here:
 *
 *   - a plain restart while another restart of the session is running
 *     returns that restart's result (joins it);
 *   - a restart that carries new settings (model, permission mode, effort)
 *     never joins; it runs after the one in progress, never alongside it.
 */
export interface RespawnQueue {
  run(sessionId: string, opts: { joinable: boolean }, restart: () => Promise<boolean>): Promise<boolean>;
  /** Whether a restart of the session is in progress (for tests). */
  busy(sessionId: string): boolean;
}

export function createRespawnQueue(): RespawnQueue {
  const inFlight = new Map<string, Promise<boolean>>();
  return {
    run(sessionId, { joinable }, restart) {
      const current = inFlight.get(sessionId);
      if (current && joinable) return current;
      const next = (current ? current.catch(() => false) : Promise.resolve(false)).then(() => restart());
      inFlight.set(sessionId, next);
      const clear = () => {
        if (inFlight.get(sessionId) === next) inFlight.delete(sessionId);
      };
      next.then(clear, clear);
      return next;
    },
    busy(sessionId) {
      return inFlight.has(sessionId);
    },
  };
}

/** Test builds only: a scenario can set `window.__HERMES_E2E_NO_RESPAWN_LOCK__`
 *  to turn joining off and show that its check catches the double start the
 *  lock prevents. Compiled out of normal builds. */
export function respawnJoinDisabledForTest(): boolean {
  if (import.meta.env.VITE_HERMES_E2E !== "1") return false;
  return (globalThis as { __HERMES_E2E_NO_RESPAWN_LOCK__?: unknown }).__HERMES_E2E_NO_RESPAWN_LOCK__ === true;
}
