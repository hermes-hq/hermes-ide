import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, RateLimitInfo } from "./types";

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
  /** Cumulative cost in USD across every `result` event seen on this
   *  session — i.e., the real spend reported by the SDK, not a derived
   *  per-token estimate.  Resets when `sessionId` changes. */
  cumulativeCostUsd: number;
  /** Cumulative input tokens (sum of usage.input_tokens across results). */
  cumulativeInputTokens: number;
  /** Cumulative output tokens. */
  cumulativeOutputTokens: number;
}

/**
 * Lightweight subscriber for the two slices of agent state the Usage panel
 * needs: `accountInfo` (one-shot, from the bridge's `_hermes_event/account_info`
 * envelope) and `rateLimits` (per-`rateLimitType` snapshots from the SDK's
 * `rate_limit_event`s).
 *
 * Lives outside the main `messageStore` reducer so the panel can render
 * even when no `<AgentSessionView>` is mounted for this session — and so we
 * don't have to lift the reducer state into a global context just to
 * surface two fields.
 */
const EMPTY_SNAPSHOT: AgentUsageSnapshot = {
  accountInfo: null,
  rateLimits: {},
  cumulativeCostUsd: 0,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
};

export function useAgentUsage(sessionId: string | null): AgentUsageSnapshot {
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }

    setSnapshot(EMPTY_SNAPSHOT);
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    (async () => {
      const un = await listen<AgentEvent>(
        `agent-event-${sessionId}`,
        (msg) => {
          const ev = msg.payload as unknown as Record<string, unknown>;
          const type = ev?.type;

          if (type === "rate_limit_event") {
            const info = ev.rate_limit_info as RateLimitInfo | undefined;
            if (!info) return;
            const kind =
              typeof info.rateLimitType === "string" ? info.rateLimitType : "default";
            setSnapshot((s) => ({
              ...s,
              rateLimits: { ...s.rateLimits, [kind]: info },
            }));
            return;
          }

          // result events carry per-turn totals — accumulate them so the
          // panel's "This session" section reflects real SDK-reported spend
          // instead of the terminal-mode token tracker (which doesn't run
          // for agent-mode sessions).
          if (type === "result") {
            const cost =
              typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0;
            const usage = ev.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            const inTok =
              typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
            const outTok =
              typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
            setSnapshot((s) => ({
              ...s,
              cumulativeCostUsd: s.cumulativeCostUsd + cost,
              cumulativeInputTokens: s.cumulativeInputTokens + inTok,
              cumulativeOutputTokens: s.cumulativeOutputTokens + outTok,
            }));
            return;
          }

          if (type === "_hermes_event" && ev.subtype === "account_info") {
            const info = ev.info as AgentAccountInfo | undefined;
            if (info && typeof info === "object") {
              setSnapshot((s) => ({ ...s, accountInfo: info }));
            }
          }
        },
      );

      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  return snapshot;
}
