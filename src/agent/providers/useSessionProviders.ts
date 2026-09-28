// ─── Wiring: run a provider for every session ─────────────────────────
//
// F19. Mounted once (App). Every terminal session goes through the
// TerminalProvider on each update; every Agent-view session through the
// Agent view provider on each change of its store. Both write into the C0
// session-event store (dispatchSessionEvent), the same place the Rust
// channel and plugins write to. A closed session's events are forgotten.
//
// It also tells the attention store which session a person is looking at,
// so a finished turn reads "done" until it is seen.

import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { clearSessionEvents, dispatchSessionEvent } from "../contract/sessionEventStore";
import { getOrCreateAgentSessionStore } from "../agentSessionStore";
import { forgetSessionStatus, markSessionSeen, setViewedSession } from "../status/attentionStore";
import { forgetUserInput } from "../status/userInput";
import type { SessionData } from "../../types/session";
import { ProviderRegistry } from "./types";
import { terminalObservationOf, terminalProvider } from "./terminalProvider";
import { agentViewObservationOf, agentViewProvider } from "./agentViewProvider";

const sink = (sessionId: string, event: Parameters<typeof dispatchSessionEvent>[1]) => {
  dispatchSessionEvent(sessionId, event);
};

export const terminalRegistry = new ProviderRegistry(terminalProvider, sink);
export const agentViewRegistry = new ProviderRegistry(agentViewProvider, sink);

/**
 * One pass over the session list: observe every terminal session, forget
 * sessions that are gone. Exported for tests; the hook calls it.
 */
export function syncTerminalSessions(sessions: readonly SessionData[], known: Set<string>, at: number): void {
  const live = new Set<string>();
  for (const s of sessions) {
    live.add(s.id);
    if (s.mode !== "agent") terminalRegistry.observe(s.id, terminalObservationOf(s), at);
  }
  for (const id of [...known]) {
    if (live.has(id)) continue;
    known.delete(id);
    terminalRegistry.forget(id);
    agentViewRegistry.forget(id);
    clearSessionEvents(id);
    forgetSessionStatus(id);
    forgetUserInput(id);
  }
  for (const id of live) known.add(id);
}

function windowIsFocused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

export function useSessionProviders(
  sessions: readonly SessionData[],
  activeSessionId: string | null,
  enabled: boolean,
): void {
  const known = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    syncTerminalSessions(sessions, known.current, Date.now());
  }, [sessions, enabled]);

  const agentIdsKey = useMemo(
    () =>
      sessions
        .filter((s) => s.mode === "agent" && s.phase !== "destroyed")
        .map((s) => s.id)
        .sort()
        .join(","),
    [sessions],
  );

  useEffect(() => {
    if (!enabled || !agentIdsKey) return;
    const unsubs = agentIdsKey.split(",").map((id) => {
      const store = getOrCreateAgentSessionStore(id, listen);
      const push = () => {
        agentViewRegistry.observe(id, agentViewObservationOf(store.getSnapshot()), Date.now());
      };
      push();
      return store.subscribe(push);
    });
    return () => {
      for (const u of unsubs) u();
    };
  }, [agentIdsKey, enabled]);

  useEffect(() => {
    if (!enabled) return;
    // Choosing a session is looking at it, focused window or not.
    if (activeSessionId) markSessionSeen(activeSessionId);
    const update = () => setViewedSession(windowIsFocused() ? activeSessionId : null);
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [activeSessionId, enabled]);
}
