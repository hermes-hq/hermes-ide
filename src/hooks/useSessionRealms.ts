import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSessionRealms, attachSessionRealm, detachSessionRealm } from "../api/realms";

// Re-export for backward compatibility
export type { Realm } from "../types/realm";

import type { Realm } from "../types/realm";

export function useSessionRealms(sessionId: string | null) {
  const [realms, setRealms] = useState<Realm[]>([]);

  // Fetch realms for active session
  useEffect(() => {
    if (!sessionId) {
      setRealms([]);
      return;
    }

    getSessionRealms(sessionId)
      .then((r) => setRealms(r))
      .catch(() => setRealms([]));

    // Listen for updates to this session's realms
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let unlistenGlobal: (() => void) | null = null;

    listen<Realm[]>(`session-realms-updated-${sessionId}`, (event) => {
      setRealms(event.payload);
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });

    // Listen for global realm updates (scan completions)
    listen<Realm>("realm-updated", () => {
      // Refetch to get updated data
      getSessionRealms(sessionId)
        .then((r) => setRealms(r))
        .catch((err) => console.warn("[useSessionRealms] Failed to refresh realms:", err));
    }).then((u) => {
      if (cancelled) { u(); } else { unlistenGlobal = u; }
    });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenGlobal?.();
    };
  }, [sessionId]);

  const attach = useCallback(async (realmId: string) => {
    if (!sessionId) return;
    await attachSessionRealm(sessionId, realmId, "primary");
  }, [sessionId]);

  const detach = useCallback(async (realmId: string) => {
    if (!sessionId) return;
    await detachSessionRealm(sessionId, realmId);
  }, [sessionId]);

  return { realms, attach, detach };
}
