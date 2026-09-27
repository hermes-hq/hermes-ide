import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Warms the Claude agent bridge (so the next agent turn starts faster) as
 * soon as an Agent-view session exists — created now or restored from the
 * last run — and never for people who only use terminals. The backend runs
 * at most one warm-up per app run, so asking again is harmless.
 */
export function useAgentBridgeWarmup(sessions: ReadonlyArray<{ mode?: string }>): void {
  const hasAgentSession = sessions.some((s) => s.mode === "agent");
  useEffect(() => {
    if (!hasAgentSession) return;
    invoke<boolean>("warm_agent_bridge").catch((err) => {
      console.warn("[agent] bridge warm-up request failed:", err);
    });
  }, [hasAgentSession]);
}
