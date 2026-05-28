import { useEffect, useMemo, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { RateLimitInfo } from "./types";
import { getOrCreateAgentSessionStore, type AgentViewSnapshot } from "./agentSessionStore";
import { emptyState } from "./messageStore";

export interface AgentAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  tokenSource?: string;
  apiProvider?: string;
}

export interface AgentUsageSnapshot {
  accountInfo: AgentAccountInfo | null;
  rateLimits: Record<string, RateLimitInfo>;
  /** Cumulative cost in USD across every `result` event seen on this session. */
  cumulativeCostUsd: number;
  /** Cumulative input tokens (sum of usage.input_tokens across results). */
  cumulativeInputTokens: number;
  /** Cumulative output tokens. */
  cumulativeOutputTokens: number;
}

const EMPTY_SNAPSHOT: AgentUsageSnapshot = {
  accountInfo: null,
  rateLimits: {},
  cumulativeCostUsd: 0,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
};

const EMPTY_VIEW_SNAPSHOT: AgentViewSnapshot = {
  state: emptyState(),
  stderr: "",
  exit: null,
  pendingPermRequest: null,
};

/**
 * Usage panel data comes from the long-lived per-session agent store.
 * This is important because rate-limit/account/result events can arrive
 * before the Usage panel is opened; a panel-local listener would miss them.
 */
export function useAgentUsage(sessionId: string | null): AgentUsageSnapshot {
  const store = useMemo(
    () => (sessionId ? getOrCreateAgentSessionStore(sessionId, listen) : null),
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    getOrCreateAgentSessionStore(sessionId, listen);
  }, [sessionId]);

  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : getEmptySnapshot,
    store ? store.getSnapshot : getEmptySnapshot,
  );

  if (!store) return EMPTY_SNAPSHOT;

  const state = snapshot.state;
  return {
    accountInfo: state.accountInfo,
    rateLimits: state.rateLimits,
    cumulativeCostUsd: state.cumulativeCostUsd,
    cumulativeInputTokens: state.cumulativeInputTokens,
    cumulativeOutputTokens: state.cumulativeOutputTokens,
  };
}

function noopSubscribe(): () => void {
  return () => {};
}

function getEmptySnapshot(): AgentViewSnapshot {
  return EMPTY_VIEW_SNAPSHOT;
}
