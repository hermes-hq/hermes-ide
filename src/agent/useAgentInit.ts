/**
 * Lightweight hook that snapshots the most-recent `system/init` event for an
 * agent session.
 *
 * The composer needs `init.slash_commands`, `init.model`, and
 * `init.permissionMode` to populate its pickers.  Subscribing here (rather
 * than through the full `messageStore` reducer) keeps the composer's
 * footprint small and avoids racing with the renderer's own reducer:
 * `agent-event-{sessionId}` is broadcast by Tauri, so multiple listeners
 * each receive their own copy without sharing mutable state.
 *
 * NOT a hook factory — exported directly so callers just write
 *   const init = useAgentInit(sessionId);
 *
 * Returns `null` until the first `init` event arrives, or whenever the
 * session id is null/empty.
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, InitEvent } from "./types";
import { isInitEvent, isStateChangedEvent } from "./types";

/** Pure reducer step — exported for unit testing.
 *
 *  Two events feed this reducer:
 *
 *    1. `system/init` (fresh from the SDK on spawn / resume) — wholly
 *       replaces the cached init.
 *    2. `_hermes_state_changed` (bridge-internal) — patches the cached
 *       init's `model` / `permissionMode` fields when Claude's runtime
 *       values drift mid-session (e.g. EnterPlanMode flips the mode
 *       without a respawn).  Ignored when no init has been seen yet —
 *       we don't want to fabricate an init from a partial state.
 */
export function reduceInit(prev: InitEvent | null, event: AgentEvent): InitEvent | null {
  if (isInitEvent(event)) return event;
  if (isStateChangedEvent(event)) {
    if (!prev) return prev;
    const next = { ...prev };
    if (typeof event.model === "string") next.model = event.model;
    if (typeof event.permissionMode === "string") {
      next.permissionMode = event.permissionMode;
    }
    return next;
  }
  return prev;
}

export function useAgentInit(sessionId: string | null | undefined): InitEvent | null {
  const [init, setInit] = useState<InitEvent | null>(null);

  useEffect(() => {
    setInit(null);
    if (!sessionId) return;
    let cancelled = false;
    let un: UnlistenFn | undefined;

    listen<AgentEvent>(`agent-event-${sessionId}`, (msg) => {
      const ev = msg.payload;
      // Funnel both event kinds through the pure reducer so the
      // patch-on-state-changed semantics are testable.
      setInit((prev) => reduceInit(prev, ev));
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        un = u;
      }
    });

    return () => {
      cancelled = true;
      un?.();
    };
  }, [sessionId]);

  return init;
}
