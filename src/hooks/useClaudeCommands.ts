import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  listClaudeCommands,
  startClaudeWatcher,
  stopClaudeWatcher,
  type ClaudeCommand,
} from "../api/sessions";

interface ClaudeCommandsChangedEvent {
  session_id: string;
}

/**
 * Read the merged list of Claude custom commands (user-global + project-local)
 * for the given session. Auto-refreshes when files in the watched dirs change.
 *
 * Returns an empty array until the first fetch completes, or when sessionId is
 * null. The watcher is started on mount and stopped on unmount or session change.
 */
export function useClaudeCommands(sessionId: string | null): ClaudeCommand[] {
  const [commands, setCommands] = useState<ClaudeCommand[]>([]);

  useEffect(() => {
    if (!sessionId) { setCommands([]); return; }

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const refresh = () => {
      listClaudeCommands(sessionId)
        .then((list) => { if (!cancelled) setCommands(list); })
        .catch((err) => { console.error("[useClaudeCommands] fetch failed:", err); });
    };

    refresh();

    startClaudeWatcher(sessionId)
      .catch((err) => console.error("[useClaudeCommands] watcher start failed:", err));

    listen<ClaudeCommandsChangedEvent>("claude-commands-changed", (e) => {
      if (cancelled) return;
      if (e.payload.session_id !== sessionId) return;
      refresh();
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch((err) => console.error("[useClaudeCommands] listen failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
      stopClaudeWatcher(sessionId).catch(() => { /* ignore */ });
    };
  }, [sessionId]);

  return commands;
}
