import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  discoverClaudeCapabilities,
  startClaudeWatcher,
  stopClaudeWatcher,
  type ClaudeCapabilities,
} from "../api/sessions";

interface ClaudeSettingsChangedEvent {
  session_id: string;
}

/**
 * Discover Claude Code's capabilities (models, effort levels, built-in slash
 * commands, current effort) for the active session. Auto-refreshes when
 * Claude's `settings.json` changes.
 *
 * Returns `null` until the first fetch resolves, or when `sessionId` is
 * `null`. The watcher is started on mount and stopped on unmount or session
 * change. The Rust-side watcher is idempotent, so it's safe for multiple
 * hooks to call start for the same session.
 */
export function useClaudeCapabilities(sessionId: string | null): ClaudeCapabilities | null {
  const [capabilities, setCapabilities] = useState<ClaudeCapabilities | null>(null);

  useEffect(() => {
    if (!sessionId) { setCapabilities(null); return; }

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const refresh = () => {
      discoverClaudeCapabilities(sessionId)
        .then((caps) => { if (!cancelled) setCapabilities(caps); })
        .catch((err) => { console.error("[useClaudeCapabilities] fetch failed:", err); });
    };

    refresh();

    startClaudeWatcher(sessionId)
      .catch((err) => console.error("[useClaudeCapabilities] watcher start failed:", err));

    listen<ClaudeSettingsChangedEvent>("claude-settings-changed", (e) => {
      if (cancelled) return;
      if (e.payload.session_id !== sessionId) return;
      refresh();
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch((err) => console.error("[useClaudeCapabilities] listen failed:", err));

    return () => {
      cancelled = true;
      unlisten?.();
      stopClaudeWatcher(sessionId).catch(() => { /* ignore */ });
    };
  }, [sessionId]);

  return capabilities;
}
