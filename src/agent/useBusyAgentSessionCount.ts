/**
 * `useBusyAgentSessionCount` — how many agent-mode sessions are currently
 * "working" (streaming a reply or running a tool), across the whole app.
 *
 * This is the signal `useAutoUpdater` waits on before it is allowed to
 * install and relaunch (N10 — an update must never kill a working agent).
 *
 * It reads the same per-session store `AgentSessionView` renders from
 * (`getOrCreateAgentSessionStore`), so a session counts as busy even while
 * its pane is not the one currently mounted — a background agent still
 * blocks the updater. `selectWorkingState(...).active` is the exact
 * "is this agent working" predicate the footline/margin-draft UI already
 * uses, so this hook and what the user sees agree by construction.
 */
import { useMemo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionList } from "../state/SessionContext";
import { getOrCreateAgentSessionStore } from "./agentSessionStore";
import { selectWorkingState } from "./workingState";

export function useBusyAgentSessionCount(): number {
  const sessions = useSessionList();

  // Keyed on the *set* of live agent-session ids (not the session objects
  // themselves, which change identity on every unrelated field update) so
  // we only re-subscribe when a session is created, closed or changes mode.
  const idsKey = useMemo(
    () =>
      sessions
        .filter((s) => s.mode === "agent" && s.phase !== "destroyed")
        .map((s) => s.id)
        .sort()
        .join(","),
    [sessions],
  );
  const agentSessionIds = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);

  const subscribe = useMemo(() => {
    return (onStoreChange: () => void) => {
      const unsubs = agentSessionIds.map((id) =>
        getOrCreateAgentSessionStore(id, listen).subscribe(onStoreChange),
      );
      return () => {
        for (const unsub of unsubs) unsub();
      };
    };
  }, [agentSessionIds]);

  const getSnapshot = useMemo(() => {
    return () =>
      agentSessionIds.reduce((count, id) => {
        const snapshot = getOrCreateAgentSessionStore(id, listen).getSnapshot();
        return selectWorkingState(snapshot.state).active ? count + 1 : count;
      }, 0);
  }, [agentSessionIds]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
