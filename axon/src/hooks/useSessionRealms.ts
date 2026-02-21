import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Realm {
  id: string;
  path: string;
  name: string;
  languages: string[];
  frameworks: string[];
  architecture: {
    pattern: string;
    layers: string[];
    entry_points: string[];
  } | null;
  conventions: { rule: string; source: string; confidence: number }[];
  scan_status: string;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

export function useSessionRealms(sessionId: string | null) {
  const [realms, setRealms] = useState<Realm[]>([]);

  // Fetch realms for active session
  useEffect(() => {
    if (!sessionId) {
      setRealms([]);
      return;
    }

    invoke("get_session_realms", { sessionId })
      .then((r) => setRealms(r as Realm[]))
      .catch(() => setRealms([]));

    // Listen for updates to this session's realms
    let unlisten: (() => void) | null = null;
    listen<Realm[]>(`session-realms-updated-${sessionId}`, (event) => {
      setRealms(event.payload);
    }).then((u) => { unlisten = u; });

    // Listen for global realm updates (scan completions)
    let unlistenGlobal: (() => void) | null = null;
    listen<Realm>("realm-updated", () => {
      // Refetch to get updated data
      invoke("get_session_realms", { sessionId })
        .then((r) => setRealms(r as Realm[]))
        .catch(() => {});
    }).then((u) => { unlistenGlobal = u; });

    return () => {
      unlisten?.();
      unlistenGlobal?.();
    };
  }, [sessionId]);

  const attach = useCallback(async (realmId: string) => {
    if (!sessionId) return;
    await invoke("attach_session_realm", { sessionId, realmId, role: "primary" });
  }, [sessionId]);

  const detach = useCallback(async (realmId: string) => {
    if (!sessionId) return;
    await invoke("detach_session_realm", { sessionId, realmId });
  }, [sessionId]);

  return { realms, attach, detach };
}
