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
import { isInitEvent } from "./types";

/** Pure reducer step — exported for unit testing. */
export function reduceInit(prev: InitEvent | null, event: AgentEvent): InitEvent | null {
  return isInitEvent(event) ? event : prev;
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
      if (isInitEvent(ev)) {
        // Each agent turn re-emits an init event with the current model /
        // permission mode / slash commands — keep replacing so the composer
        // chips track Claude's reality.
        // Visible debug: prints model/permission as plain strings so
        // DevTools doesn't truncate as `Object`.
        console.log(
          `[useAgentInit] sid=${sessionId} model=${ev.model ?? "?"}` +
          ` perm=${(ev as { permissionMode?: string }).permissionMode ?? "?"}`,
        );
        setInit(ev);
      }
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
