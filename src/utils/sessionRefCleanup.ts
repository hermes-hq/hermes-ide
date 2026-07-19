/**
 * Pure helper for tearing down per-session ref-Map state when a
 * session is removed.
 *
 * Why this isn't inlined into SessionContext's listener
 * ─────────────────────────────────────────────────────
 * The v1.1.0 audit (see `agent-store-regressions-1-1-2.test.ts`)
 * found three Maps that were never cleaned up: `claudeAddDirs`,
 * `lastIdeStateHash`, `lastAutoAttachCwd`.  The 500 ms close-
 * fallback `setTimeout` was also leaking because the real
 * `session-removed` event arriving first didn't cancel the timer.
 *
 * Extracting the cleanup as a pure function gives us:
 *   1. A single canonical list of "things to forget per session" so
 *      a future ref addition has one obvious place to plug into.
 *   2. Direct unit-test coverage that doesn't need the React
 *      component tree, Tauri mocks, or event listener plumbing.
 */

export interface SessionRefBundle {
  busyTimestamps: Map<string, unknown>;
  closingSessionIds: Set<string>;
  closeTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastAutoAttachCwd: Map<string, string>;
  claudeUuids: Map<string, string>;
  claudeModels: Map<string, string | undefined>;
  claudePermissionModes: Map<string, string | undefined>;
  claudeEfforts: Map<string, string | undefined>;
  claudeAddDirs: Map<string, string[]>;
  pendingFlags: Map<string, unknown>;
  lastIdeStateHash: Map<string, string>;
  autoNamedSessions: Set<string>;
}

/**
 * Drop every per-session entry for `sessionId`, AND cancel any
 * pending close-fallback timer.  Returns the number of map deletes
 * that actually removed something — useful for the regression test
 * that verifies the leak is closed (was 0/8 maps cleaned up, should
 * now be all-of-them).
 */
export function cleanupSessionRefs(
  bundle: SessionRefBundle,
  sessionId: string,
): { removed: number; cancelledTimer: boolean } {
  let removed = 0;
  const tryDelete = (m: Map<string, unknown> | Set<string>) => {
    if ("delete" in m) {
      const had = m.delete(sessionId as never);
      if (had) removed += 1;
    }
  };

  tryDelete(bundle.busyTimestamps as Map<string, unknown>);
  tryDelete(bundle.closingSessionIds);
  tryDelete(bundle.lastAutoAttachCwd as Map<string, unknown>);
  tryDelete(bundle.claudeUuids as Map<string, unknown>);
  tryDelete(bundle.claudeModels as Map<string, unknown>);
  tryDelete(bundle.claudePermissionModes as Map<string, unknown>);
  tryDelete(bundle.claudeEfforts as Map<string, unknown>);
  tryDelete(bundle.claudeAddDirs as Map<string, unknown>);
  tryDelete(bundle.pendingFlags as Map<string, unknown>);
  tryDelete(bundle.lastIdeStateHash as Map<string, unknown>);
  tryDelete(bundle.autoNamedSessions);

  // Cancel + delete any pending close-fallback timer (H2 fix).
  let cancelledTimer = false;
  const pending = bundle.closeTimers.get(sessionId);
  if (pending !== undefined) {
    clearTimeout(pending);
    bundle.closeTimers.delete(sessionId);
    cancelledTimer = true;
  }

  return { removed, cancelledTimer };
}
